"""Multiple explicitly paired references with disjoint chromosome namespaces."""
import os
import pysam
from services.fasta_handles import ThreadLocalFasta
from services.gene_annotations import load_gtf
from utils.chrom import normalize_chrom_name, build_chrom_map


class ReferenceCollection:
    def __init__(self, handles):
        self.handles = list(handles)
        self.by_name = {}
        normalized = set()
        for handle in self.handles:
            for name in handle.references:
                key = normalize_chrom_name(name)
                if key in normalized:
                    raise ValueError(f'Chromosome {name} occurs in multiple FASTAs. Use distinct contig names for haplotypes/assemblies.')
                normalized.add(key)
                self.by_name[name] = handle
        self.references = tuple(self.by_name)
        self.lengths = tuple(self.get_reference_length(name) for name in self.references)
        self.nreferences = len(self.references)

    def fetch(self, reference=None, start=None, end=None, **kwargs):
        return self.by_name[reference].fetch(reference, start, end, **kwargs)

    def get_reference_length(self, reference):
        return self.by_name[reference].get_reference_length(reference)

    def close(self):
        for handle in self.handles:
            handle.close()


def load_reference_pairs(state, pairs):
    """Load a reference collection; published under the state lock (callers may already hold it)."""
    from services.genome_loading import reference_lock
    with reference_lock(state):
        return _load_reference_pairs_locked(state, pairs)


def _load_reference_pairs_locked(state, pairs):
    """Validate all pairs before replacing active reference state."""
    from routers.genome import _merge_gtf_data
    if not pairs:
        raise ValueError('Add at least one FASTA reference')
    handles, annotations, manifest = [], None, []
    try:
        for i, pair in enumerate(pairs):
            fasta = os.path.abspath(os.path.expanduser(pair['fasta']))
            if not os.path.isfile(fasta):
                raise ValueError(f'FASTA not found: {fasta}')
            if not os.path.isfile(fasta+'.fai'):
                from services.lab.paths import confine_sidecar
                confine_sidecar(fasta + '.fai')  # a lab server: never into a read-only data root
                pysam.faidx(fasta)
            handles.append(ThreadLocalFasta(fasta))
            annotation = pair.get('annotation')
            if annotation:
                annotation = os.path.abspath(os.path.expanduser(annotation))
                if not os.path.isfile(annotation):
                    raise ValueError(f'Annotation not found: {annotation}')
                data = load_gtf(annotation)
                annotation_chroms = set(data['transcripts'].get('norm_chrom', []))
                reference_chroms = {normalize_chrom_name(name) for name in handles[-1].references}
                if annotation_chroms and not annotation_chroms <= reference_chroms:
                    raise ValueError(f'Annotation chromosomes absent from paired FASTA: {sorted(annotation_chroms-reference_chroms)[:5]}')
                # Transcript identifiers may recur across haplotype files.
                for key in ('transcripts','exons'):
                    if 'transcript_id' in data[key]:
                        data[key]['transcript_id'] = data[key]['transcript_id'].map(lambda value: f'reference-{i}:{value}')
                data['tx_by_chrom'] = {name:group for name,group in data['transcripts'].groupby('norm_chrom')} if len(data['transcripts']) else {}
                annotations = _merge_gtf_data(annotations, data)
            manifest.append(dict(fasta=fasta, annotation=annotation))
        reference = ReferenceCollection(handles)
    except Exception:
        for handle in handles:
            handle.close()
        raise
    state.fasta = reference
    state.fasta_path = manifest[0]['fasta']
    # Plasmids loaded before belong to the previous reference (and would
    # shadow a same-named contig of this one); circular flags follow it.
    state.plasmid_sequences = {}
    state.plasmid_metadata = {}
    state._reset_circular_chroms_for_reference(reference)
    state.reference_pairs = manifest
    # The new contigs first: the annotations record the lengths of the
    # reference they were loaded against (so a later switch can drop them).
    state.chroms = [state._chrom_info_with_circular_flags(name,reference.get_reference_length(name)) for name in reference.references]
    state.chrom_map = build_chrom_map(state.chroms)
    state.gtf_data = annotations
    state.gtf_path = os.pathsep.join(pair['annotation'] for pair in manifest if pair['annotation']) or None
    state.current_genome = None
    state.fasta_error = None
    return dict(success=True, pairs=manifest, sequences=reference.nreferences,
                gene_count=len(annotations['transcripts']) if annotations else 0)
