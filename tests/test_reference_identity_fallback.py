"""An insert expanded from a custom-named main FASTA keeps the source's species (Codex MED, fb62).

custom_reference.fa with dm6's chromosome lengths had coordinate_genome dm6 but no reference_genome, so its
expanded insert inherited no genome and took vertebrate motifs and no fly TE library. The main FASTA's verified
assembly fingerprint is now an identity fallback; the insert keeps its own coordinates.
"""
from types import SimpleNamespace

from services.genome_check import canonical_contigs
from services.motifs import coordinate_genome, jaspar_genome, reference_genome_basis


def _state(genome, name="custom_reference.fa", current=None):
    contigs = canonical_contigs(genome)
    fasta = SimpleNamespace(references=list(contigs), lengths=list(contigs.values()),
                            get_reference_length=lambda n: contigs[n])
    return SimpleNamespace(fasta=fasta, fasta_path=f"/data/{name}", current_genome=current,
                           plasmid_sequences={}, chroms=[])


def test_a_custom_named_main_fasta_is_known_by_its_assembly():
    state = _state("dm6")
    assert reference_genome_basis(state) == ("dm6", "assembly")
    assert coordinate_genome(state) == "dm6"
    assert jaspar_genome(state) == ("dm6", False)


def test_the_expanded_insert_inherits_it():
    from services.alt_allele import _genome_of
    assert _genome_of(_state("dm6")) == "dm6"


def test_an_unrecognised_fasta_still_has_no_identity_and_a_loaded_genome_wins():
    unknown = SimpleNamespace(fasta=SimpleNamespace(references=["contig1"], lengths=[5000],
                                                    get_reference_length=lambda n: 5000),
                              fasta_path="/data/construct.fa", current_genome=None, plasmid_sequences={}, chroms=[])
    assert reference_genome_basis(unknown) == (None, None)
    assert reference_genome_basis(_state("dm6", current="dm6")) == ("dm6", "genome")
