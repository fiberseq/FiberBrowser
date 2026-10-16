import asyncio

import pandas as pd

from models.domain import ChromInfo
from routers.genome import get_sequence, load_plasmid_endpoint, load_plasmids_endpoint
from utils.chrom import build_chrom_map, translate_chrom


class FakePlasmidState:
    def __init__(self):
        self.fasta = None
        self.fasta_error = None
        self.fasta_path = None
        self.gtf_data = None
        self.gtf_path = None
        self.current_genome = None
        self.circular_chroms = {}
        self.plasmid_sequences = {}
        self.plasmid_metadata = {}
        self.chroms = []
        self.chrom_map = {}

    def translate_chrom(self, chrom):
        return translate_chrom(chrom, self.chrom_map)

    def _chrom_size_for(self, chrom):
        translated = self.translate_chrom(chrom)
        for entry in self.chroms:
            if entry.name in {chrom, translated}:
                return entry.size
        sequence = self.plasmid_sequences.get(chrom) or self.plasmid_sequences.get(translated)
        return len(sequence) if sequence else None

    def _chrom_info_with_circular_flags(self, name, size):
        meta = self.circular_chroms.get(name)
        return ChromInfo(
            name=name,
            size=int(size),
            circular=bool(meta),
            circular_source=meta.get("source") if meta else None,
        )

    def add_supplemental_plasmid_reference(
        self,
        name,
        sequence,
        *,
        source="plasmid_map",
        path=None,
        label=None,
        circular=True,
    ):
        self.plasmid_sequences[name] = sequence.upper()
        self.plasmid_metadata[name] = {
            "source": source,
            "path": path,
            "label": label or name,
            "size": len(sequence),
            "circular": bool(circular),
        }
        if circular:
            self.circular_chroms[name] = {
                "source": source,
                "size": len(sequence),
                "label": label,
                "path": path,
            }
        else:
            self.circular_chroms.pop(name, None)
        self.chroms = [entry for entry in self.chroms if entry.name != name]
        self.chroms.append(self._chrom_info_with_circular_flags(name, len(sequence)))
        self.chrom_map = build_chrom_map(self.chroms)


def write_genbank(path, *, name="pRoute", gene="geneA", sequence="ACGTACGTACGTACGTACGTACGT"):
    path.write_text(
        f"""LOCUS       {name:<12}{len(sequence)} bp    DNA     circular SYN 01-JAN-2000
FEATURES             Location/Qualifiers
     gene            3..12
                     /gene="{gene}"
ORIGIN
        1 {sequence.lower()}
//
""",
        encoding="utf-8",
    )


def test_load_plasmid_endpoint_adds_supplemental_chromosome(tmp_path):
    path = tmp_path / "route_test.gbk"
    write_genbank(path)
    state = FakePlasmidState()

    result = asyncio.run(load_plasmid_endpoint(str(path), state=state))

    assert result["success"] is True
    assert result["name"] == "pRoute"
    assert result["length"] == 24
    assert result["feature_count"] == 1
    assert result["circular"] is True
    assert state.current_genome == "plasmids"
    assert state.gtf_path == str(path)
    assert state.plasmid_sequences["pRoute"] == "ACGTACGTACGTACGTACGTACGT"
    assert state.plasmid_metadata["pRoute"]["path"] == str(path)
    assert state.circular_chroms["pRoute"]["source"] == "plasmid_map"
    assert [entry.name for entry in state.chroms] == ["pRoute"]
    assert list(state.gtf_data["transcripts"]["gene_name"]) == ["geneA"]
    assert "proute" in state.gtf_data["tx_by_chrom"]


def test_load_plasmid_preserves_existing_genome_and_annotations(tmp_path):
    path = tmp_path / "route_test.gbk"
    write_genbank(path)
    state = FakePlasmidState()
    state.current_genome = "dm6"
    state.chroms = [ChromInfo(name="chr2L", size=1000)]
    state.chrom_map = build_chrom_map(state.chroms)
    state.gtf_path = "/refs/dm6.gtf"
    state.gtf_data = {
        "transcripts": pd.DataFrame([{
            "chrom": "chr2L",
            "start": 10,
            "end": 20,
            "strand": "+",
            "transcript_id": "tx0",
            "gene_name": "existingGene",
            "biotype": "protein_coding",
            "norm_chrom": "2l",
        }]),
        "exons": pd.DataFrame([{"chrom": "chr2L", "start": 10, "end": 20, "transcript_id": "tx0"}]),
        "tx_by_chrom": {},
    }

    result = asyncio.run(load_plasmid_endpoint(str(path), state=state))

    assert result["success"] is True
    assert state.current_genome == "dm6"
    assert [entry.name for entry in state.chroms] == ["chr2L", "pRoute"]
    assert list(state.gtf_data["transcripts"]["gene_name"]) == ["existingGene", "geneA"]
    assert "2l" in state.gtf_data["tx_by_chrom"]
    assert "proute" in state.gtf_data["tx_by_chrom"]
    assert state.gtf_path == f"/refs/dm6.gtf:{path}"


def test_get_sequence_serves_wrapped_supplemental_plasmid(tmp_path):
    path = tmp_path / "route_test.gbk"
    write_genbank(path)
    state = FakePlasmidState()
    asyncio.run(load_plasmid_endpoint(str(path), state=state))

    result = asyncio.run(get_sequence("pRoute", 20, 28, state=state))

    assert result == {
        "sequence": "ACGTACGT",
        "chrom": "pRoute",
        "start": 20,
        "end": 28,
        "circular": True,
    }


def test_load_plasmids_endpoint_adds_multiple_references(tmp_path):
    path_a = tmp_path / "a.gbk"
    path_b = tmp_path / "b.gbk"
    write_genbank(path_a, name="pA", gene="geneA")
    write_genbank(path_b, name="pB", gene="geneB")
    state = FakePlasmidState()

    result = asyncio.run(load_plasmids_endpoint([str(path_a), str(path_b)], state=state))

    assert result["success"] is True
    assert result["count"] == 2
    assert result["errors"] == []
    assert set(state.plasmid_sequences) == {"pA", "pB"}
    assert [entry.name for entry in state.chroms] == ["pA", "pB"]
    assert list(state.gtf_data["transcripts"]["gene_name"]) == ["geneA", "geneB"]


def test_load_plasmid_endpoint_surfaces_parser_warnings(tmp_path):
    path = tmp_path / "route_test.fa"
    path.write_text(">pWarn\nACGTACGTACGT\n", encoding="utf-8")
    state = FakePlasmidState()

    result = asyncio.run(load_plasmid_endpoint(str(path), state=state))

    assert result["success"] is True
    assert result["warnings"]
    assert "No companion GFF3 or BED" in result["warnings"][0]
