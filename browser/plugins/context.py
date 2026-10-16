"""Clean interface to BrowserState for plugin authors.

Wraps BrowserState to expose a stable API surface that plugins can rely on,
decoupling them from internal implementation details.
"""


class AnalysisContext:
    def __init__(self, state):
        self._state = state

    def get_working_set(self, dataset_id: str, chrom: str, start: int, end: int,
                        spanning: bool = False, read_ids: list = None):
        """Build a working set for a viewport region."""
        if hasattr(self._state, "resolve_dataset_id"):
            dataset_id = self._state.resolve_dataset_id(dataset_id)
        return self._state.build_working_set(dataset_id, chrom, start, end,
                                             spanning=spanning, read_ids=read_ids)

    def get_dataset_ids(self) -> list:
        """Return ordered list of dataset IDs."""
        return list(self._state.dataset_order)

    def get_dataset(self, dataset_id: str):
        """Get a dataset by ID."""
        if hasattr(self._state, "resolve_dataset_id"):
            dataset_id = self._state.resolve_dataset_id(dataset_id)
        return self._state.get_dataset(dataset_id)

    def has_fasta(self) -> bool:
        """Whether a reference FASTA is loaded."""
        return self._state.fasta is not None

    def fetch_sequence(self, chrom: str, start: int, end: int):
        """Fetch reference sequence for a region. Returns None if no FASTA loaded."""
        if self._state.fasta is None:
            return None
        try:
            return self._state.fasta.fetch(chrom, start, end)
        except Exception:
            return None

    def get_genes(self, chrom: str, start: int, end: int) -> list:
        """Get gene annotations overlapping a region."""
        if self._state.gtf_data is None:
            return []
        tx_df = self._state.gtf_data.get('transcripts')
        if tx_df is None or tx_df.empty:
            return []
        from utils.chrom import get_chrom_variants
        chrom_variants = get_chrom_variants(chrom)
        visible = tx_df[(tx_df['chrom'].isin(chrom_variants)) & (tx_df['start'] <= end) & (tx_df['end'] >= start)]
        return [
            {
                "id": str(row['transcript_id']),
                "name": str(row['gene_name']),
                "start": int(row['start']),
                "end": int(row['end']),
                "strand": str(row['strand']),
            }
            for _, row in visible.iterrows()
        ]

    @property
    def current_genome(self):
        """Currently loaded genome ID (e.g. 'hg38', 'dm6'), or None."""
        return self._state.current_genome

    def get_chromosomes(self) -> list:
        """Return list of ChromInfo dicts with name and size."""
        return [{'name': c.name, 'size': c.size} for c in self._state.chroms]

    def get_reads(self, dataset_id: str, chrom: str, start: int, end: int,
                  spanning: bool = True) -> list:
        """Get compact reads for a region. Each read has intervals, read_id, etc."""
        ws = self.get_working_set(dataset_id, chrom, start, end, spanning=spanning)
        return ws.reads if ws else []

    def get_footprint_sizes(self, dataset_id: str, chrom: str, start: int, end: int,
                            spanning: bool = True) -> list:
        """Extract all footprint sizes from reads in a region."""
        reads = self.get_reads(dataset_id, chrom, start, end, spanning=spanning)
        sizes = []
        for read in reads:
            for interval in read.get('intervals', []):
                sizes.append(interval[1] - interval[0])
        return sizes

    def get_track_data(self, track_index: int, chrom: str, start: int, end: int) -> dict:
        """Get data from an orthogonal track (bigWig signal or BED annotation)."""
        if track_index < 0 or track_index >= len(self._state.orthogonal_tracks):
            return {'label': '', 'values': []}
        track = self._state.orthogonal_tracks[track_index]
        try:
            return self._state.get_track_data(track_index, chrom, start, end)
        except Exception:
            return {'label': track.get('label', ''), 'values': []}

    def get_config(self) -> dict:
        """Get server configuration."""
        return dict(self._state.config)
