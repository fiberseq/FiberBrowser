# Workflow: plasmids and circular genomes

[← Docs index](../index.md) · [← README](../../README.md)

FiberBrowser loads a plasmid map as an extra, circular chromosome. The map
supplies the sequence and the annotated features; your aligned BAM supplies the
reads. The **Regions** panel draws the plasmid as a circular map. This is useful
for fiber-seq or DAF-seq on reporter constructs and other small circular
references.

## 1. Load a plasmid map

Any of these works:

- **Open** in the top bar, or drag the map onto the window.
- **Regions** panel → **Map** tab → **Load plasmid map…**.
- Sidebar → **Reference & Tracks → Reference Files**, or **Data & Sessions →
  Load by path**.

Formats: SnapGene `.dna`, GenBank `.gb` / `.gbk` / `.genbank`, EMBL `.embl`,
and SBOL. SnapGene import is best-effort; for exact sequence and features,
export GenBank from SnapGene.

On load:

- The plasmid becomes a chromosome named after the map: the file name
  without its extension for SnapGene (`L-HH.dna` → `L-HH`), the `LOCUS` (or
  EMBL `ID`) name for GenBank and EMBL. Characters other than letters,
  digits, `_`, `.` and `-` become `_`. A BAM's contig may have any name
  (section 3).
- It is circular unless the file declares it linear.
- Its features are added to the gene annotations, so they draw in the gene
  track and can be searched.
- If dataset panels are showing the genome, the plasmid opens in a copy of the
  panel next to them and the main view stays put. Otherwise the main view moves
  to the plasmid.

## 2. The circular map

Open **Regions** (rail, **View** group), tab **Map**. On a circular
chromosome it shows:

- Features as directional arrows, coloured by type. Hover a feature for its
  name, type, strand and coordinates.
- Feature labels with leader lines when the panel is maximized. In the docked
  panel only the selected feature is labelled.
- bp ticks, a highlight for the current view, and the plasmid name and size in
  the centre.

Click a feature (or its label) to select it and zoom the main view to it. Click
elsewhere on the map to move the view there.

The **Circular** / **Linear** button switches how the current chromosome is
treated (manual circular mode is limited to chromosomes up to 10 Mb). Below the
map, **Zoom window** shows the features around the view. To keep a view, use
**Save view** in the panel's **Regions** tab: it goes to a category of saved
regions (named after its nearest gene), and ticked regions open side by side
with **Open side by side** (see [Regions](../guide.md#31-regions)).

## 3. Reads on the plasmid

FiberBrowser displays aligned reads; it does not align them. Load the map
and a BAM aligned to the plasmid's sequence, in either order. The BAM's
contig does **not** need the map's name or the map's origin: FiberBrowser
finds the contig that is the map's sequence and shows its reads on the map.

### Open plasmid dataset (one step)

**Regions** panel → **Map** → **Open plasmid dataset…** (or sidebar **Reference &
Tracks → Reference Files → Plasmid maps → With reads…**). In the file
dialog choose the map and its BAM file(s) together; add the FASTA the reads
were aligned to if the BAM does not name it (see below). If you pick only
the map, or only BAMs, a second dialog asks for the rest.

FiberBrowser loads the map, adds each BAM as a dataset, links every BAM
contig that is the map's sequence, and opens the reads on the plasmid.
Loading the files any other way (**Open**, dragging them onto the
window, **Load by path**, a saved session) links them the same way.

### How a BAM is matched to a map

Only a contig with the map's length is considered, and it is linked only when
its sequence is shown to be the map's:

1. its `@SQ M5` checksum equals the map's (md5 of the uppercase sequence);
2. else the reference FASTA the BAM was aligned to: the FASTA you chose, the
   `@SQ UR` path, or the FASTA on the aligner's `@PG` command line (minimap2
   records it). This also finds an **origin-rotated** reference;
3. else the reference bases the reads carry (`MD` tags, written by
   `minimap2 --MD`), which also find a rotation;
4. else a `@CO FIBERHMM-REFERENCE` line (below) that names this map.

A contig with the same name as the map and nothing to check it is still
shown there, as before.

**Rotated references.** When the BAM was aligned to a copy of the plasmid
that starts elsewhere (for example an `_orirot.fasta` that moves the origin
to the middle of the ori), the map is shown in the BAM's frame: its sequence
and features are rotated so position 0 is the BAM's position 0, and a
feature across the new origin is drawn across it. If a second BAM uses yet
another origin, it gets its own copy of the map, named after its contig.

The **Regions** panel's **Map** tab on a plasmid lists the linked BAMs (contig → map,
origin shift, how it was checked).

### When a BAM does not match

The message says what differs and how to fix it:

| Message | Meaning | Fix |
|---|---|---|
| *X is N bp but map M is K bp* / *No contig of B is a loaded plasmid map* | Different sequence: the reads were aligned to another plasmid or version. | Load the map of that reference, or align the reads to this map. |
| *same length, … N bases differ (first at X:pos)* | The map is not exactly the sequence the reads were aligned to (for example the designed map vs the sequenced plasmid). | Update the map, or **Link anyway**. |
| *X is the reverse complement of map M* | The reference is the other strand. | Reverse-complement the map (or the reference) so they agree. |
| *same length, but … no M5 checksum, reference FASTA or MD tags* | Nothing to check the sequence with. | Choose the reference FASTA in **Open plasmid dataset…**, or **Link anyway** if it is the same plasmid with the same origin. |

**Link anyway** (in the **Regions** panel's **Map** tab, next to the message) links a
same-length contig without a sequence check. A session remembers every link,
including these.

### The FIBERHMM-REFERENCE header

`fiberhmm-pipeline` (FiberHMM) aligns reads to a plasmid map and records it in
the BAM header, one line per contig:

```text
@CO	FIBERHMM-REFERENCE:v1:contig=L-HH;length=5054;md5=<md5>;topology=circular;source=L-HH.dna;source_format=snapgene;source_sha256=<sha256>
```

`;`-separated `key=value` fields, values percent-encoded. `source` is the map
file, next to the BAM; `md5` is the contig's `@SQ M5`. When you load such a
BAM, FiberBrowser loads that map too (unless it is already loaded, or the
file's SHA-256 no longer matches) and links it. The short form
`map=<file>;contig=<name>;circular=1;map_md5=<md5 of the map's uppercase
sequence>` is also read, with optional `offset=<bp>` (the contig is the map
rotated by that many bases) and `fasta=<alignment FASTA>`.

### Align FASTQ to a plasmid

`fiberhmm-pipeline` (FiberHMM) aligns and calls in one command and writes
the header above. For alignment alone, `scripts/align_plasmid_reads.py`
needs `minimap2` and `samtools` on your `PATH`:

```bash
# Nanopore (default preset map-ont)
python scripts/align_plasmid_reads.py L-HH.dna reads.fastq.gz

# Several FASTQs merged into one BAM
python scripts/align_plasmid_reads.py L-HH.dna run1.fastq.gz run2.fastq.gz

# PacBio
python scripts/align_plasmid_reads.py L-HH.dna reads.fq.gz --preset map-hifi
```

It writes the map's sequence as a FASTA, runs `minimap2 -ax <preset> --MD`
into `samtools sort`, and indexes the BAM (`L-HH.aligned.bam`). Maps can be
`.dna`, `.gb`, `.gbk`, `.genbank` or FASTA.

| Option | Meaning |
|--------|---------|
| `--name NAME` | Contig name (default: the name FiberBrowser gives the map). |
| `--preset P` | minimap2 preset (`map-ont` default; `map-hifi` or `map-pb` for PacBio). |
| `-o`, `--outdir DIR` | Output directory (default: next to the map file). |
| `-t`, `--threads N` | Threads (default 4). |

## 4. Footprints on a plasmid

A plain minimap2 BAM shows alignments and, for DAF-seq, deamination marks.
For nucleosome, TF and accessibility layers, run
[FiberHMM](https://github.com/fiberseq/FiberHMM) on the aligned BAM and
load its output. See [DAF-seq](daf-seq.md).

## Tips

- If reads do not appear, open **Regions → Map** on the plasmid: it says which BAMs
  are linked and why the others are not.
- A linear reference cannot wrap, so reads crossing position 0 are split by the
  aligner. FiberBrowser shows primary alignments only; supplementary pieces are
  not drawn.
- Coverage on small plasmids is often very high. The display draws a sample;
  analyses still use every eligible read unless you set **Analysis cap**.
