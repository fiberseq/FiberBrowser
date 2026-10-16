#!/usr/bin/env python3
"""
Interactive Primer Design Tool
Designs primers for a gene/region and allows interactive selection of primer clusters.

Usage:
    By gene name (with coverage requirement):
        python primer_designer.py --gene sog --rel-start -10000 --rel-end 10000 \\
            --cover-start -2000 --cover-end 3000 \\
            --fasta dm6.fa --blast-db dm6 --gtf dm6.gtf
    
    By coordinates:
        python primer_designer.py --chrom chr2L --start 1000000 --end 1020000 \\
            --strand + --name my_region --fasta dm6.fa --blast-db dm6

Parameters:
    Search region: --rel-start, --rel-end (where to look for primers)
    Product size: --min-dist, --max-dist (min/max PCR product size)
    Coverage: --cover-start, --cover-end (product must span at least this region)
"""

import argparse
import os
import sys
import tempfile
import numpy as np
import pandas as pd
from tqdm import tqdm
from sklearn.cluster import DBSCAN

# matplotlib, seaborn, seqfold, primer3 are lazy-imported in the functions /
# classes that actually use them. The browser imports small helpers (`rc`,
# `make_fa_dic`) from this module at server start; making those imports
# top-level would force every deployment to install the GUI-only deps
# (matplotlib, seaborn) and the primer-only deps (primer3, seqfold) even
# when the user never opens the Primer panel.


# =============================================================================
# Core Functions
# =============================================================================


def _blastn() -> str:
    """blastn as the shared resolver finds it (app bundle, PATH, Homebrew, conda)."""
    try:
        from services.external_tools import tool_path
        return tool_path("blastn") or "blastn"
    except Exception:
        return "blastn"

def make_fa_dic(infile):
    """Import dictionary of sequences from fasta file."""
    fdic = {}
    chrom_filter = False
    with open(infile, 'r') as f:
        total_lines = sum(1 for line in f)
    with open(infile, 'r') as f:
        for line in tqdm(f, total=total_lines, desc="Importing fasta", leave=False):
            line = line.rstrip()
            if '>' in line:
                chrom = line.split()[0].replace('>', '')
                if 'chr' not in chrom:
                    chrom = 'chr' + chrom
                chrom_filter = True
                fdic[chrom] = []
            elif chrom_filter:
                fdic[chrom].append(line.upper())
    for chrom in fdic:
        fdic[chrom] = ''.join(fdic[chrom])
    return fdic


def calc_tm(seq):
    """Calculate melting temperature using nearest-neighbor method (SantaLucia 1998)."""
    import primer3
    return primer3.calc_tm(seq)


def last_Gs(seq, max_gs):
    """Check G content constraints."""
    if seq.count("G") > max_gs:
        return False
    if 'G' in seq[-5:]:
        return False
    return True


def test_structure(seq):
    """Test for problematic secondary structures."""
    from seqfold import fold
    structs = fold(seq)
    for struct in structs:
        g = struct.e
        s_type = struct.desc
        if 'STACK' in s_type and g < -5:
            return False
        elif 'HAIRPIN' in s_type and g < -2:
            return False
    return True


def check_self_dimers(seq):
    """Check for self-dimers."""
    import primer3
    tm = primer3.bindings.calc_heterodimer(seq, seq).tm
    return tm < 50


def rc(seq):
    """Reverse complement."""
    return seq.translate(str.maketrans({'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C'}))[::-1]


def find_filter_primers(seq, primer_len, start, min_tm, max_tm, max_gs, reverse):
    """Find and filter primers of given length."""
    primers = np.array([seq[i:i+primer_len] for i in range(0, len(seq)-primer_len+1)])
    primer_starts = np.arange(0, len(seq)-primer_len+1) + start

    if reverse:
        primer_starts = primer_starts[::-1]

    if primers.size == 0:
        return (np.array([], dtype=int), np.array([], dtype=object), np.array([], dtype=float))

    # Only A/C/G/T: an ambiguous base (N) makes primer3's Tm raise.
    acgt = np.array([set(p) <= {'A', 'C', 'G', 'T'} for p in primers], dtype=bool)
    primer_starts, primers = primer_starts[acgt], primers[acgt]
    if primers.size == 0:
        return (np.array([], dtype=int), np.array([], dtype=object), np.array([], dtype=float))

    # Tm filter
    tms = np.vectorize(calc_tm, otypes=[float])(primers)
    tm_mask = (min_tm <= tms) & (tms <= max_tm)
    primer_starts, primers, tms = primer_starts[tm_mask], primers[tm_mask], tms[tm_mask]

    if primers.size == 0:
        return (np.array([], dtype=int), np.array([], dtype=object), np.array([], dtype=float))

    # No Gs at end filter
    end_mask = np.vectorize(lambda p: last_Gs(p, max_gs), otypes=[bool])(primers)
    primer_starts, primers, tms = primer_starts[end_mask], primers[end_mask], tms[end_mask]

    if primers.size == 0:
        return (np.array([], dtype=int), np.array([], dtype=object), np.array([], dtype=float))

    # Secondary structure filter
    struct_mask = np.vectorize(test_structure, otypes=[bool])(primers)
    primer_starts, primers, tms = primer_starts[struct_mask], primers[struct_mask], tms[struct_mask]

    if primers.size == 0:
        return (np.array([], dtype=int), np.array([], dtype=object), np.array([], dtype=float))

    # Self-dimer filter
    dimer_mask = np.vectorize(check_self_dimers, otypes=[bool])(primers)
    primer_starts, primers, tms = primer_starts[dimer_mask], primers[dimer_mask], tms[dimer_mask]

    return primer_starts, primers, tms


def blast_primers(pairs_df, db_path):
    """BLAST primers against genome database."""
    with tempfile.NamedTemporaryFile(delete=False, mode='w', suffix='.fa') as tmp_fasta:
        i = 1
        print(f"BLASTing {len(pairs_df['fwd_sequences'].unique())} unique forward primers "
              f"and {len(pairs_df['rev_sequences'].unique())} unique reverse primers")

        seq_dic = {}
        for primer in pairs_df['fwd_sequences'].unique():
            tmp_fasta.write(f'>primer_{i}\n{primer}\n')
            seq_dic[f'primer_{i}'] = primer
            i += 1
        for primer in pairs_df['rev_sequences'].unique():
            tmp_fasta.write(f'>primer_{i}\n{primer}\n')
            seq_dic[f'primer_{i}'] = primer
            i += 1
        fasta_filename = tmp_fasta.name

    tmp_output = tempfile.NamedTemporaryFile(delete=False, suffix='.txt')
    output_filename = tmp_output.name
    tmp_output.close()

    import subprocess
    try:
        result = subprocess.run(
            [_blastn(), '-query', fasta_filename, '-db', db_path, '-word_size', '7',
             '-task', 'blastn-short',
             '-outfmt', '6 qseqid pident length mismatch gapopen qstart qend sstart send evalue bitscore',
             '-out', output_filename, '-evalue', '1'],
            capture_output=True
        )

        if result.returncode != 0:
            print(f"Warning: BLAST returned non-zero exit code {result.returncode}")
            print("  Make sure BLAST is installed and the database path is correct")
            return pairs_df.iloc[0:0]  # Return empty dataframe with same columns

        # Check if output file has content
        if os.path.getsize(output_filename) == 0:
            print("Warning: BLAST returned no hits")
            return pairs_df.iloc[0:0]

        tmp_df = pd.read_csv(output_filename, sep='\t', header=None)
    finally:
        # Temp files go whatever happens (a failed BLAST included).
        for path in (fasta_filename, output_filename):
            try:
                os.unlink(path)
            except OSError:
                pass

    tmp_df.columns = ['qid', 'pident', 'length', 'mismatch', 'gapopen', 'qstart', 'qend',
                      'sstart', 'send', 'evalue', 'bitscore']
    tmp_df['seq'] = tmp_df['qid'].map(seq_dic)
    counts = tmp_df['seq'].value_counts().to_dict()
    pairs_df = pairs_df.copy()
    pairs_df['blast_fwd'] = pairs_df['fwd_sequences'].map(counts)
    pairs_df['blast_rev'] = pairs_df['rev_sequences'].map(counts)

    return pairs_df.loc[(pairs_df['blast_fwd'] == 1) & (pairs_df['blast_rev'] == 1)]


def check_dimers(row):
    """Check for primer dimers between fwd and rev."""
    import primer3
    tm = primer3.bindings.calc_heterodimer(row['rev_sequences'], row['fwd_sequences']).tm
    return 'y' if tm < 40 else 'n'


def count_gs(row):
    """Count total Gs in primer pair."""
    return row['fwd_sequences'].count('G') + row['rev_sequences'].count('G')


def combine_ids(fwd_ids_final, rev_ids_final):
    """Combine matching ID pairs into a dataframe."""
    pairs = pd.DataFrame([fwd_ids_final, rev_ids_final]).T
    pairs = pairs.drop_duplicates()
    pairs.columns = ['fwd', 'rev']
    return pairs


def load_gtf(gtf_path):
    """Load and process GTF file."""
    gtf_df = pd.read_csv(gtf_path, sep='\t', comment='#', header=None)
    gtf_df.columns = ['chrom', 'source', 'biotype', 'start', 'end', 'score', 'strand', 'frame', 'info']
    # GTF is 1-based inclusive; like the browser (services/gene_annotations.py),
    # use 0-based half-open: start - 1, end unchanged.
    gtf_df['start'] = gtf_df['start'].astype(int) - 1
    gt = gtf_df.loc[gtf_df['biotype'] == 'gene']
    attributes_split = gt['info'].str.split(';', expand=True).iloc[:, :7]
    attributes_dicts = []

    for index, row in attributes_split.iterrows():
        attributes_dict = {}
        for attribute in row:
            try:
                if '"' in str(attribute):
                    key, value = attribute.split('"', 1)
                    attributes_dict[key.strip()] = value.split('"')[0].strip()
            except Exception:
                attributes_dict['description'] = 'X'
        attributes_dicts.append(attributes_dict)

    attributes_df = pd.DataFrame(attributes_dicts)
    gtf_df = pd.concat([gt.reset_index(drop=True), attributes_df.reset_index(drop=True)], axis=1)

    gtf_df.loc[gtf_df['strand'] == '-', 'TSS'] = gtf_df.loc[gtf_df['strand'] == '-']['end'] - 1  # exclusive end
    gtf_df.loc[gtf_df['strand'] == '+', 'TSS'] = gtf_df.loc[gtf_df['strand'] == '+']['start']
    gtf_df = gtf_df.dropna(subset='TSS')
    gtf_df['TSS'] = gtf_df['TSS'].astype(int)
    gtf_df = gtf_df.reset_index(drop=True)
    # Prefix bare names (1 -> chr1); names that already have it stay as they are.
    gtf_df['chrom'] = gtf_df['chrom'].astype(str)
    bare = ~gtf_df['chrom'].str.startswith('chr')
    gtf_df.loc[bare, 'chrom'] = 'chr' + gtf_df.loc[bare, 'chrom']
    gtf_df['chrom'] = gtf_df['chrom'].replace('chrmitochondrion_genome', 'chrM')
    gtf_df['chrom'] = gtf_df['chrom'].replace('chrrDNA', 'rDNA')

    return gtf_df


# =============================================================================
# Interactive Cluster Selection
# =============================================================================

class ClusterSelector:
    """Interactive cluster selector with matplotlib."""

    def __init__(self, heatmap_data, best_pairs, all_pairs, outdir, gene_name, strand, start, end, TSS):
        import matplotlib.pyplot as plt
        import seaborn as sns
        self._plt = plt
        self._sns = sns
        self.heatmap_data = heatmap_data
        self.best_pairs = best_pairs
        self.all_pairs = all_pairs
        self.outdir = outdir
        self.gene_name = gene_name
        self.strand = strand
        self.start = start
        self.end = end
        self.TSS = TSS
        self.selected_clusters = set()

        # Set up the figure
        n_clusters = heatmap_data.shape[0]
        fig_height = max(6, n_clusters // 3 + 3)
        self.fig, self.ax = plt.subplots(figsize=(12, fig_height))
        plt.subplots_adjust(bottom=0.2, right=0.85)
        
        # Draw heatmap
        self.im = sns.heatmap(data=heatmap_data, cmap='Blues', vmin=0, vmax=10,
                              cbar=False, ax=self.ax)
        # Silence unused-import warnings for interactive-only deps.
        _ = (self._plt, self._sns)
        
        # Set up x-axis labels
        width = heatmap_data.shape[1]
        N = width // 5
        tick_positions = np.linspace(0, width, N, endpoint=False)
        if strand == '-':
            tick_labels = np.linspace(-(end - TSS), -(start - TSS), N, endpoint=False).astype(int)
        else:
            tick_labels = np.linspace(start - TSS, end - TSS, N, endpoint=False).astype(int)
        
        self.ax.set_xticks(tick_positions)
        self.ax.set_xticklabels(tick_labels)
        self.ax.set_ylabel('Cluster (click to select)')
        self.ax.set_xlabel('Position relative to TSS (bp)')
        self.ax.set_title(f'{gene_name} Primer Clusters\nClick rows to select, then Save')
        
        # Highlight selected rows
        self.highlights = []
        
        # Add buttons
        from matplotlib.widgets import Button
        ax_save = plt.axes([0.7, 0.05, 0.15, 0.05])
        ax_clear = plt.axes([0.5, 0.05, 0.15, 0.05])
        ax_all = plt.axes([0.3, 0.05, 0.15, 0.05])

        self.btn_save = Button(ax_save, 'Save Selected')
        self.btn_clear = Button(ax_clear, 'Clear Selection')
        self.btn_all = Button(ax_all, 'Select All')
        
        self.btn_save.on_clicked(self.save_selected)
        self.btn_clear.on_clicked(self.clear_selection)
        self.btn_all.on_clicked(self.select_all)
        
        # Connect click event
        self.fig.canvas.mpl_connect('button_press_event', self.on_click)
        
        # Selection info text
        self.info_text = self.fig.text(0.1, 0.05, 'Selected: none', fontsize=10)
        
    def on_click(self, event):
        """Handle click events on heatmap."""
        if event.inaxes != self.ax:
            return
        
        # Get clicked row (cluster)
        cluster_idx = int(event.ydata)
        if cluster_idx < 0 or cluster_idx >= self.heatmap_data.shape[0]:
            return
        
        # Toggle selection
        cluster_num = cluster_idx + 1  # Clusters are 1-indexed in the data
        if cluster_num in self.selected_clusters:
            self.selected_clusters.remove(cluster_num)
        else:
            self.selected_clusters.add(cluster_num)
        
        self.update_display()
        
    def update_display(self):
        """Update the display with current selection."""
        # Clear old highlights
        for h in self.highlights:
            h.remove()
        self.highlights = []
        
        # Add new highlights
        for cluster_num in self.selected_clusters:
            cluster_idx = cluster_num - 1
            rect = self._plt.Rectangle((0, cluster_idx), self.heatmap_data.shape[1], 1,
                                       fill=False, edgecolor='red', linewidth=2)
            self.highlights.append(self.ax.add_patch(rect))
        
        # Update info text
        if self.selected_clusters:
            selected_str = ', '.join(map(str, sorted(self.selected_clusters)))
            self.info_text.set_text(f'Selected: {selected_str}')
        else:
            self.info_text.set_text('Selected: none')
        
        self.fig.canvas.draw()
        
    def clear_selection(self, event):
        """Clear all selections."""
        self.selected_clusters = set()
        self.update_display()
        
    def select_all(self, event):
        """Select all clusters."""
        self.selected_clusters = set(range(1, self.heatmap_data.shape[0] + 1))
        self.update_display()
        
    def save_selected(self, event):
        """Save selected clusters to file."""
        if not self.selected_clusters:
            print("No clusters selected!")
            return
        
        selected_list = sorted(self.selected_clusters)
        
        # Get best pairs for selected clusters
        output_df = self.best_pairs.loc[self.best_pairs['cluster'].isin(selected_list)]
        
        # Primary output columns: gene-orientation naming (clearer)
        output_cols = ['cluster', 
                       'upstream_seq', 'upstream_pos', 'upstream_tm', 'upstream_len',
                       'downstream_seq', 'downstream_pos', 'downstream_tm', 'downstream_len',
                       'tm_diff', 'g_ct', 'product_size',
                       # Also include genomic columns for reference
                       'fwd_sequences', 'fwd_starts', 'rev_sequences', 'rev_starts']
        output_cols = [c for c in output_cols if c in output_df.columns]
        
        outfile = f'{self.outdir}/{self.gene_name}_selected_primers.tsv'
        output_df[output_cols].to_csv(outfile, sep='\t', index=False)
        print(f"\nSaved {len(output_df)} primer pairs to: {outfile}")
        
        # Also save all pairs for selected clusters
        all_outfile = f'{self.outdir}/{self.gene_name}_all_selected_pairs.tsv'
        all_output = self.all_pairs.loc[self.all_pairs['cluster'].isin(selected_list)]
        all_output[output_cols].to_csv(all_outfile, sep='\t', index=False)
        print(f"Saved all {len(all_output)} pairs from selected clusters to: {all_outfile}")
        
    def show(self):
        """Display the interactive plot."""
        self._plt.show()


# =============================================================================
# Main Pipeline
# =============================================================================

def design_primers(args):
    """Main primer design pipeline."""
    
    # Load GTF if using gene name
    gtf_df = None
    if args.gene:
        gtf_df = load_gtf(args.gtf)
    
    # Determine coordinates
    if args.gene:
        query = gtf_df[gtf_df['gene_name'].str.lower() == args.gene.lower()].copy()
        if query.empty:
            print(f"Error: Gene '{args.gene}' not found in GTF file")
            sys.exit(1)
        
        TSS = query['TSS'].values[0]
        chrom = query['chrom'].values[0]
        strand = query['strand'].values[0]
        name = args.gene
        
        # Convert gene-relative coordinates to genomic coordinates
        # rel_start/rel_end are in gene orientation (negative = upstream, positive = downstream)
        if strand == '+':
            # + strand: upstream = lower genomic coords, downstream = higher
            start = TSS + args.rel_start - 500
            end = TSS + args.rel_end + 500
        else:
            # - strand: upstream = higher genomic coords, downstream = lower
            # So rel_start=-5000 (5kb upstream) means TSS+5000 genomically
            # And rel_end=+10000 (10kb downstream) means TSS-10000 genomically
            start = TSS - args.rel_end - 500
            end = TSS - args.rel_start + 500
    else:
        chrom = args.chrom
        start = args.start - 500
        end = args.end + 500
        strand = args.strand
        name = args.name
        TSS = (args.start + args.end) // 2  # Use midpoint as reference
    
    print(f"\n{'='*60}")
    print(f"Primer Design for: {name}")
    print(f"Chromosome: {chrom}, Strand: {strand}")
    print(f"TSS/Reference point: {TSS:,}")
    print(f"Search region (genomic): {start:,} - {end:,}")
    if args.gene:
        # Show search region in gene-relative terms
        if strand == '+':
            rel_start = start - TSS
            rel_end = end - TSS
        else:
            # For - strand, flip the sign: lower genomic = more downstream (positive in gene coords)
            rel_start = -(end - TSS)
            rel_end = -(start - TSS)
        print(f"Search region (gene-relative): {rel_start:+,} to {rel_end:+,}")
    if args.cover_start is not None or args.cover_end is not None:
        cs = f"{args.cover_start:+,}" if args.cover_start is not None else "any"
        ce = f"{args.cover_end:+,}" if args.cover_end is not None else "any"
        print(f"Coverage requirement (gene-relative): product must span [{cs} to {ce}]")
    print(f"{'='*60}\n")
    
    # Create output directory
    outdir = args.outdir or f'primers/{name}__{chrom}:{start}-{end}_{strand}'
    os.makedirs(outdir, exist_ok=True)
    
    # Load fasta
    print("Loading reference genome...")
    fa = make_fa_dic(args.fasta)
    
    # Verify chromosome exists
    if chrom not in fa:
        print(f"Error: Chromosome '{chrom}' not found in FASTA file")
        print(f"Available chromosomes: {', '.join(sorted(fa.keys())[:10])}...")
        sys.exit(1)
    
    # Find all primers
    primer_df = pd.DataFrame()
    for primer_len in tqdm(range(args.min_len, args.max_len + 1), desc='Finding primers'):
        seq = fa[chrom][start:end]
        
        # Forward primers
        primer_starts, primers, tms = find_filter_primers(
            seq, primer_len, start, args.min_tm, args.max_tm, args.max_gs, False)
        tmp_fwd = pd.DataFrame({'starts': primer_starts, 'sequences': primers, 'tms': tms})
        tmp_fwd['strand'] = '+'
        
        # Reverse primers
        primer_starts, primers, tms = find_filter_primers(
            rc(seq), primer_len, start, args.min_tm, args.max_tm, args.max_gs, True)
        # Convert to half-open right boundary (consistent with forward primers)
        primer_starts = primer_starts + primer_len
        tmp_rev = pd.DataFrame({'starts': primer_starts, 'sequences': primers, 'tms': tms})
        tmp_rev['strand'] = '-'
        
        tmp = pd.concat([tmp_fwd, tmp_rev])
        tmp['length'] = primer_len
        tmp['chrom'] = chrom
        primer_df = pd.concat([primer_df, tmp])
    
    primer_df = primer_df.sort_values(by='starts').reset_index(drop=True)
    print(f"\n{primer_df.shape[0]} total primers identified")
    
    if primer_df.empty:
        print("Error: No primers found with given parameters")
        sys.exit(1)
    
    # Find valid pairs
    fwd_rows = primer_df.loc[primer_df['strand'] == '+']
    rev_rows = primer_df.loc[primer_df['strand'] == '-']
    
    print(f"Forward primers: {len(fwd_rows)}, Reverse primers: {len(rev_rows)}")
    
    # Chunk processing for large datasets
    n_chunks = max(1, fwd_rows.shape[0] // 10000)
    fwd_chunks = np.array_split(fwd_rows, n_chunks) if n_chunks > 1 else [fwd_rows]
    
    rev_ids_dist_final = np.array([])
    fwd_ids_dist_final = np.array([])
    rev_ids_tm_final = np.array([])
    fwd_ids_tm_final = np.array([])
    
    for fwd_chunk in tqdm(fwd_chunks, desc='Finding pairs'):
        fwd_starts = fwd_chunk['starts'].to_numpy()
        rev_chunk = rev_rows.loc[(rev_rows['starts'] >= (min(fwd_starts) + args.min_dist)) &
                                  (rev_rows['starts'] <= (max(fwd_starts) + args.max_dist))]
        
        if rev_chunk.empty:
            continue
            
        rev_starts = rev_chunk['starts'].to_numpy()
        fwd_tms = fwd_chunk['tms'].to_numpy()
        rev_tms = rev_chunk['tms'].to_numpy()
        fwd_ids = fwd_chunk.index.to_numpy()
        rev_ids = rev_chunk.index.to_numpy()
        
        # Distance matrix
        dist_matrix = rev_starts[:, None] - fwd_starts
        dist_pairs = np.argwhere((dist_matrix <= args.max_dist) & (dist_matrix >= args.min_dist))
        
        # Tm matrix
        tm_matrix = rev_tms[:, None] - fwd_tms
        tm_pairs = np.argwhere(np.abs(tm_matrix) <= args.tm_diff)
        
        rev_id_matrix = rev_ids[:, None]
        fwd_id_matrix = fwd_ids
        
        rev_ids_dist_chunk = rev_id_matrix[dist_pairs[:, 0]]
        fwd_ids_dist_chunk = fwd_id_matrix[dist_pairs[:, 1]]
        rev_ids_tm_chunk = rev_id_matrix[tm_pairs[:, 0]]
        fwd_ids_tm_chunk = fwd_id_matrix[tm_pairs[:, 1]]
        
        rev_ids_dist_final = np.concatenate((rev_ids_dist_final, rev_ids_dist_chunk.ravel()))
        fwd_ids_dist_final = np.concatenate((fwd_ids_dist_final, fwd_ids_dist_chunk.ravel()))
        rev_ids_tm_final = np.concatenate((rev_ids_tm_final, rev_ids_tm_chunk.ravel()))
        fwd_ids_tm_final = np.concatenate((fwd_ids_tm_final, fwd_ids_tm_chunk.ravel()))
    
    print("Combining pairs...")
    pairs_dist = combine_ids(fwd_ids_dist_final, rev_ids_dist_final)
    pairs_tm = combine_ids(fwd_ids_tm_final, rev_ids_tm_final)
    pairs = pairs_dist.merge(pairs_tm)
    
    if pairs.empty:
        print("Error: No valid primer pairs found")
        sys.exit(1)
    
    # Build pairs dataframe
    fwd_df = primer_df.iloc[pairs['fwd']].reset_index(drop=True)
    fwd_df = fwd_df.drop(['strand'], axis=1)
    fwd_df.columns = 'fwd_' + np.array(fwd_df.columns)
    
    rev_df = primer_df.iloc[pairs['rev']].reset_index(drop=True)
    rev_df = rev_df.drop(['strand', 'chrom'], axis=1)
    rev_df.columns = 'rev_' + np.array(rev_df.columns)
    
    pairs = pd.concat([fwd_df, rev_df], axis=1)
    print(f"{pairs.shape[0]} pairs identified")
    
    # Coverage filter: product must span the required region
    if args.cover_start is not None or args.cover_end is not None:
        pre_shape = pairs.shape[0]
        
        if strand == '+':
            # For + strand: fwd_starts is product start, rev_starts is product end
            if args.cover_start is not None:
                # Product must start at or before cover_start
                max_fwd_pos = TSS + args.cover_start
                pairs = pairs.loc[pairs['fwd_starts'] <= max_fwd_pos]
            if args.cover_end is not None:
                # Product must end at or after cover_end
                min_rev_pos = TSS + args.cover_end
                pairs = pairs.loc[pairs['rev_starts'] >= min_rev_pos]
        else:
            # For - strand: gene coordinates are flipped relative to genomic
            # Gene "start" is at higher genomic coords, gene "end" at lower
            if args.cover_start is not None:
                # Product must start (in gene terms) at or before cover_start
                # Gene start = rev_starts; cover_start relative = TSS - cover_start genomic
                min_rev_pos = TSS - args.cover_start
                pairs = pairs.loc[pairs['rev_starts'] >= min_rev_pos]
            if args.cover_end is not None:
                # Product must end (in gene terms) at or after cover_end
                # Gene end = fwd_starts; cover_end relative = TSS - cover_end genomic
                max_fwd_pos = TSS - args.cover_end
                pairs = pairs.loc[pairs['fwd_starts'] <= max_fwd_pos]
        
        print(f"{pre_shape} -> {pairs.shape[0]} pairs after coverage filter")
        
        if pairs.empty:
            print("Error: No pairs remain after coverage filtering")
            print(f"  Try adjusting --cover-start/--cover-end or expanding the search region")
            sys.exit(1)
    
    # Dimer check
    print("Checking for primer dimers...")
    pre_shape = pairs.shape[0]
    pairs['dimer'] = pairs.apply(check_dimers, axis=1)
    pairs = pairs.loc[pairs['dimer'] == 'y']
    print(f"{pre_shape} -> {pairs.shape[0]} pairs after dimer check")
    
    if pairs.empty:
        print("Error: No pairs remain after dimer filtering")
        sys.exit(1)
    
    # BLAST
    print("BLASTing primers...")
    pre_shape = pairs.shape[0]
    pairs = blast_primers(pairs, args.blast_db)
    print(f"{pre_shape} -> {pairs.shape[0]} pairs after BLAST")
    
    if pairs.empty:
        print("Error: No pairs remain after BLAST filtering")
        sys.exit(1)
    
    # Calculate additional metrics
    pairs['tm_diff'] = np.abs(pairs['fwd_tms'] - pairs['rev_tms'])
    pairs['g_ct'] = pairs.apply(count_gs, axis=1)
    pairs['product_size'] = pairs['rev_starts'] - pairs['fwd_starts']
    
    # Add gene-relative positions and clear upstream/downstream labeling
    # fwd primer is always at lower genomic coords, rev at higher
    # But in gene orientation, which is "upstream" depends on strand
    if strand == '+':
        # + strand: fwd (lower coord) = upstream, rev (higher coord) = downstream
        pairs['upstream_seq'] = pairs['fwd_sequences']
        pairs['downstream_seq'] = pairs['rev_sequences']
        pairs['upstream_pos'] = pairs['fwd_starts'] - TSS  # negative = upstream of TSS
        pairs['downstream_pos'] = pairs['rev_starts'] - TSS  # positive = downstream of TSS
        pairs['upstream_tm'] = pairs['fwd_tms']
        pairs['downstream_tm'] = pairs['rev_tms']
        pairs['upstream_len'] = pairs['fwd_length']
        pairs['downstream_len'] = pairs['rev_length']
    else:
        # - strand: rev (higher coord) = upstream, fwd (lower coord) = downstream
        pairs['upstream_seq'] = pairs['rev_sequences']
        pairs['downstream_seq'] = pairs['fwd_sequences']
        pairs['upstream_pos'] = -(pairs['rev_starts'] - TSS)  # flip sign for gene orientation
        pairs['downstream_pos'] = -(pairs['fwd_starts'] - TSS)
        pairs['upstream_tm'] = pairs['rev_tms']
        pairs['downstream_tm'] = pairs['fwd_tms']
        pairs['upstream_len'] = pairs['rev_length']
        pairs['downstream_len'] = pairs['fwd_length']
    
    # Keep legacy rel columns for compatibility, but calculate correctly
    pairs['rel_fwd_start'] = pairs['fwd_starts'] - TSS
    pairs['rel_rev_start'] = pairs['rev_starts'] - TSS
    
    # Cluster primers
    print("Clustering primers...")
    tmp = pairs.loc[:, ['fwd_starts', 'rev_starts']].copy()
    tmp['fwd_starts'] = tmp['fwd_starts'] // 100
    tmp['rev_starts'] = tmp['rev_starts'] // 100
    
    dbscan = DBSCAN(eps=1.5, min_samples=5)
    tmp['cluster'] = dbscan.fit_predict(tmp[['fwd_starts', 'rev_starts']])
    
    # Filter out noise cluster (-1)
    valid_clusters = tmp['cluster'] >= 0
    pairs = pairs.loc[valid_clusters].copy()
    tmp = tmp.loc[valid_clusters].copy()
    
    n_clusters = len(tmp['cluster'].unique())
    print(f"Identified {n_clusters} clusters")
    
    if n_clusters == 0:
        print("Error: No valid clusters found")
        sys.exit(1)
    
    # Renumber clusters starting from 1
    cluster_mapping = {old: new + 1 for new, old in enumerate(sorted(tmp['cluster'].unique()))}
    tmp['cluster'] = tmp['cluster'].map(cluster_mapping)
    pairs['cluster'] = tmp['cluster']
    
    # Build heatmap data
    heatmap_data = []
    for cluster in sorted(pairs['cluster'].unique()):
        cluster_pairs = pairs.loc[pairs['cluster'] == cluster]
        a = np.zeros(((end - start) // 100) + 1)
        for _, row in cluster_pairs.iterrows():
            fwd_bin = int(row['fwd_starts'] - start) // 100
            rev_bin = int(row['rev_starts'] - start) // 100
            if 0 <= fwd_bin < len(a):
                a[fwd_bin] += 1
            if 0 <= rev_bin < len(a):
                a[rev_bin] += 1
        heatmap_data.append(a)
    
    heatmap_data = np.array(heatmap_data)
    if strand == '-':
        heatmap_data = np.fliplr(heatmap_data)
    
    # Get best pairs per cluster
    best_pairs = pairs.sort_values(by=['g_ct', 'tm_diff']).drop_duplicates(subset=['cluster']).sort_values(by='cluster')
    
    # Save all results
    pairs.to_csv(f'{outdir}/{name}_all_pairs.tsv', sep='\t', index=False)
    best_pairs.to_csv(f'{outdir}/{name}_best_pairs.tsv', sep='\t', index=False)
    print(f"\nSaved all pairs to: {outdir}/{name}_all_pairs.tsv")
    print(f"Saved best pairs to: {outdir}/{name}_best_pairs.tsv")
    
    # Save heatmap image (CLI-only path — browser never executes this).
    import matplotlib.pyplot as plt
    import seaborn as sns
    plt.figure(figsize=(10, max(3, n_clusters // 3)))
    sns.heatmap(data=heatmap_data, cmap='Blues', vmin=0, vmax=10, cbar=False)
    width = heatmap_data.shape[1]
    N = width // 5
    tick_positions = np.linspace(0, width, N, endpoint=False)
    if strand == '-':
        tick_labels = np.linspace(-(end - TSS), -(start - TSS), N, endpoint=False).astype(int)
    else:
        tick_labels = np.linspace(start - TSS, end - TSS, N, endpoint=False).astype(int)
    plt.xticks(tick_positions, tick_labels)
    plt.ylabel('Cluster')
    plt.xlabel('Position relative to TSS (bp)')
    plt.title(f'{name} Primer Clusters')
    plt.tight_layout()
    plt.savefig(f'{outdir}/{name}_clusters.png', dpi=150)
    print(f"Saved cluster plot to: {outdir}/{name}_clusters.png")
    plt.close()
    
    # Launch interactive selector unless --no-interactive
    if args.no_interactive:
        print("\n" + "="*60)
        print("Non-interactive mode: auto-selecting best primer pair")
        
        # Score each cluster's best pair by how well it matches desired parameters
        # Lower score = better
        def score_pair(row):
            score = 0
            
            # If coverage requirements specified, penalize overshoot on either end
            if args.cover_start is not None:
                # Want upstream_pos <= cover_start (more negative is further upstream)
                # Overshoot = how much further upstream than needed
                overshoot = args.cover_start - row['upstream_pos']
                if overshoot < 0:
                    # Doesn't reach cover_start - heavily penalize
                    score += 10000
                else:
                    score += overshoot
            
            if args.cover_end is not None:
                # Want downstream_pos >= cover_end
                # Overshoot = how much further downstream than needed
                overshoot = row['downstream_pos'] - args.cover_end
                if overshoot < 0:
                    # Doesn't reach cover_end - heavily penalize
                    score += 10000
                else:
                    score += overshoot
            
            # If no coverage requirements, prefer middle of size range
            if args.cover_start is None and args.cover_end is None:
                target_size = (args.min_dist + args.max_dist) / 2
                score += abs(row['product_size'] - target_size)
            
            # Tiebreakers: g_ct and tm_diff (already optimized in best_pairs, but add small weight)
            score += row['g_ct'] * 10
            score += row['tm_diff'] * 5
            
            return score
        
        best_pairs_scored = best_pairs.copy()
        best_pairs_scored['_score'] = best_pairs_scored.apply(score_pair, axis=1)
        selected = best_pairs_scored.nsmallest(1, '_score').drop(columns=['_score'])
        
        # Save the selected pair
        output_cols = ['cluster', 
                       'upstream_seq', 'upstream_pos', 'upstream_tm', 'upstream_len',
                       'downstream_seq', 'downstream_pos', 'downstream_tm', 'downstream_len',
                       'tm_diff', 'g_ct', 'product_size',
                       'fwd_sequences', 'fwd_starts', 'rev_sequences', 'rev_starts']
        output_cols = [c for c in output_cols if c in selected.columns]
        
        outfile = f'{outdir}/{name}_selected_primers.tsv'
        selected[output_cols].to_csv(outfile, sep='\t', index=False)
        
        # Print summary
        row = selected.iloc[0]
        print(f"\nSelected cluster {int(row['cluster'])}:")
        print(f"  Upstream primer:   {row['upstream_seq']} (pos: {int(row['upstream_pos']):+}, Tm: {row['upstream_tm']:.1f})")
        print(f"  Downstream primer: {row['downstream_seq']} (pos: {int(row['downstream_pos']):+}, Tm: {row['downstream_tm']:.1f})")
        print(f"  Product size: {int(row['product_size'])} bp, Tm diff: {row['tm_diff']:.1f}, G count: {int(row['g_ct'])}")
        print(f"\nSaved to: {outfile}")
        print(f"All clusters available in: {outdir}/{name}_best_pairs.tsv")
        print("="*60 + "\n")
    else:
        print("\n" + "="*60)
        print("Launching interactive cluster selector...")
        print("Click on rows to select clusters, then click 'Save Selected'")
        print("="*60 + "\n")
        
        selector = ClusterSelector(heatmap_data, best_pairs, pairs, outdir, name, strand, start, end, TSS)
        selector.show()


def main():
    parser = argparse.ArgumentParser(
        description='Interactive Primer Design Tool',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  By gene name (search -10kb to +10kb, product must cover -2kb to +3kb):
    %(prog)s --gene sog --rel-start -10000 --rel-end 10000 \\
             --cover-start -2000 --cover-end 3000 \\
             --fasta dm6.fa --blast-db dm6 --gtf dm6.gtf
  
  By coordinates:
    %(prog)s --chrom chr2L --start 1000000 --end 1020000 --strand + --name my_region \\
             --fasta dm6.fa --blast-db dm6
  
  With custom product size (8-15kb products):
    %(prog)s --gene sog --rel-start -10000 --rel-end 10000 \\
             --min-dist 8000 --max-dist 15000 \\
             --fasta dm6.fa --blast-db dm6 --gtf dm6.gtf
        """
    )
    
    # Input mode: gene name OR coordinates
    input_group = parser.add_argument_group('Input (choose gene OR coordinates)')
    input_group.add_argument('--gene', type=str, help='Gene name to design primers for')
    input_group.add_argument('--rel-start', type=int, default=-10000,
                             help='Start position relative to TSS (default: -10000)')
    input_group.add_argument('--rel-end', type=int, default=10000,
                             help='End position relative to TSS (default: 10000)')
    
    input_group.add_argument('--chrom', type=str, help='Chromosome (e.g., chr2L)')
    input_group.add_argument('--start', type=int, help='Start coordinate')
    input_group.add_argument('--end', type=int, help='End coordinate')
    input_group.add_argument('--strand', type=str, choices=['+', '-'], help='Strand')
    input_group.add_argument('--name', type=str, help='Name for output files')
    
    # Required paths
    paths_group = parser.add_argument_group('Required paths')
    paths_group.add_argument('--fasta', type=str, required=True, help='Path to genome FASTA file')
    paths_group.add_argument('--blast-db', type=str, required=True, help='Path to BLAST database')
    paths_group.add_argument('--gtf', type=str, help='Path to GTF file (required if using --gene)')
    
    # Primer parameters
    primer_group = parser.add_argument_group('Primer parameters')
    primer_group.add_argument('--min-tm', type=float, default=55, help='Minimum Tm (default: 55)')
    primer_group.add_argument('--max-tm', type=float, default=65, help='Maximum Tm (default: 65)')
    primer_group.add_argument('--min-len', type=int, default=18, help='Minimum primer length (default: 18)')
    primer_group.add_argument('--max-len', type=int, default=25, help='Maximum primer length (default: 25)')
    primer_group.add_argument('--max-gs', type=int, default=2, help='Maximum G count (default: 2)')
    primer_group.add_argument('--tm-diff', type=float, default=2, help='Maximum Tm difference (default: 2)')
    
    # Product size parameters
    dist_group = parser.add_argument_group('Product size parameters')
    dist_group.add_argument('--min-dist', type=int, default=5000,
                            help='Minimum PCR product size (default: 5000)')
    dist_group.add_argument('--max-dist', type=int, default=20000,
                            help='Maximum PCR product size (default: 20000)')
    
    # Coverage requirement parameters
    cover_group = parser.add_argument_group('Coverage requirements (relative to TSS)')
    cover_group.add_argument('--cover-start', type=int, default=None,
                             help='Product must START at or before this position relative to TSS (e.g., -2000)')
    cover_group.add_argument('--cover-end', type=int, default=None,
                             help='Product must END at or after this position relative to TSS (e.g., 3000)')
    
    # Output
    parser.add_argument('--outdir', type=str, help='Output directory (default: primers/<name>_...)')
    parser.add_argument('--no-interactive', action='store_true',
                        help='Skip interactive cluster selection (just save all results)')
    
    args = parser.parse_args()
    
    # Validate input mode
    if args.gene:
        if not args.gtf:
            parser.error("--gtf is required when using --gene")
    elif args.chrom:
        if not all([args.start, args.end, args.strand, args.name]):
            parser.error("When using coordinates, all of --chrom, --start, --end, --strand, --name are required")
    else:
        parser.error("Must specify either --gene or coordinate arguments (--chrom, --start, --end, --strand, --name)")
    
    design_primers(args)


if __name__ == '__main__':
    main()
