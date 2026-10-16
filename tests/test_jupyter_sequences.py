from types import SimpleNamespace

from services.jupyter_sequences import (
    extract_sequence_regions,
    get_cached_fasta_dict,
    resolve_fasta_chrom,
)


def test_get_cached_fasta_dict_loads_once_and_handles_missing_cache_attribute():
    state = SimpleNamespace(primer_fasta="/tmp/ref.fa")
    calls = []

    def loader(path):
        calls.append(path)
        return {"chr1": "ACGT"}

    first = get_cached_fasta_dict(state, loader=loader)
    second = get_cached_fasta_dict(state, loader=loader)

    assert first == {"chr1": "ACGT"}
    assert second is first
    assert calls == ["/tmp/ref.fa"]


def test_get_cached_fasta_dict_reloads_when_the_primer_fasta_changes():
    state = SimpleNamespace(primer_fasta="/tmp/a.fa")
    calls = []

    def loader(path):
        calls.append(path)
        return {"chr1": path}

    assert get_cached_fasta_dict(state, loader=loader) == {"chr1": "/tmp/a.fa"}
    state.primer_fasta = "/tmp/b.fa"
    assert get_cached_fasta_dict(state, loader=loader) == {"chr1": "/tmp/b.fa"}
    assert calls == ["/tmp/a.fa", "/tmp/b.fa"]


def test_resolve_fasta_chrom_uses_chr_prefix_aliases():
    fa = {"chr2L": "ACGT", "3R": "TTAA"}

    assert resolve_fasta_chrom(fa, "2L") == "chr2L"
    assert resolve_fasta_chrom(fa, "chr3R") == "3R"
    assert resolve_fasta_chrom(fa, "X") is None


def test_extract_sequence_regions_extends_clips_and_reverse_complements():
    regions = [
        SimpleNamespace(chrom="2L", start=2, end=6, name="target"),
        SimpleNamespace(chrom="X", start=0, end=3, name=None),
    ]

    results = extract_sequence_regions(
        regions,
        {"chr2L": "AACCGTTA"},
        extend=2,
        strand="-",
        reverse_complement=lambda seq: seq[::-1].translate(str.maketrans("ACGT", "TGCA")),
    )

    assert results == [
        {
            "chrom": "2L",
            "start": 0,
            "end": 8,
            "name": "target",
            "sequence": "TAACGGTT",
            "length": 8,
        },
        {
            "chrom": "X",
            "start": 0,
            "end": 5,
            "name": "region_1",
            "sequence": None,
            "error": "Chromosome X not found in FASTA",
        },
    ]


def test_extract_sequence_regions_wraps_circular_chromosomes():
    regions = [
        SimpleNamespace(chrom="plasmid", start=8, end=14, name="seam"),
        SimpleNamespace(chrom="plasmid", start=-3, end=3, name="negative"),
    ]

    results = extract_sequence_regions(
        regions,
        {"plasmid": "AACCGGTTAA"},
        circular_chrom_sizes={"plasmid": 10},
    )

    assert results == [
        {
            "chrom": "plasmid",
            "start": 8,
            "end": 14,
            "name": "seam",
            "sequence": "AAAACC",
            "length": 6,
            "circular": True,
        },
        {
            "chrom": "plasmid",
            "start": -3,
            "end": 3,
            "name": "negative",
            "sequence": "TAAAAC",
            "length": 6,
            "circular": True,
        },
    ]
